// Package crypt wraps a checkpoint row store with AES-GCM encryption and ships two stores (memory
// and SQLite) that the conformance suite in internal/store/conformance runs against.
//
// Design follows langgraph's EncryptedSerializer: a row's Type is tagged "<type>+aesgcm" when the
// payload is encrypted, so rows written before a key was configured still load.
package crypt

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
)

// CipherTag is appended to a row's Type when its Data is encrypted.
const CipherTag = "+aesgcm"

// KeySize is the AES key length in bytes (AES-256).
const KeySize = 32

// Row is one checkpoint row. Seq is assigned by the store on Put and orders rows within a thread.
type Row struct {
	Thread string
	ID     string
	Type   string
	Data   []byte
	Seq    int64
}

// Store holds checkpoint rows keyed by thread and id.
type Store interface {
	// Put inserts or replaces the row at (Thread, ID); a replaced row gets a new, higher Seq.
	Put(ctx context.Context, r Row) error
	// Get returns the row at (thread, id), and false when there is none.
	Get(ctx context.Context, thread, id string) (Row, bool, error)
	// Latest returns the row with the highest Seq in thread, and false when the thread is empty.
	Latest(ctx context.Context, thread string) (Row, bool, error)
	// PruneKeepLatest deletes every row except the latest one in each thread, and returns how many it deleted.
	PruneKeepLatest(ctx context.Context) (int, error)
}

// LoadKey reads a 32 byte key from path, as raw bytes or 64 hex characters. A file readable by
// group or others is refused. The key is never taken from a command-line value.
func LoadKey(path string) ([]byte, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("key file: %w", err)
	}
	if fi.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("key file %s is accessible by group or others; chmod 600", path)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("key file: %w", err)
	}
	if h := bytes.TrimSpace(b); len(h) == 2*KeySize {
		if k, err := hex.DecodeString(string(h)); err == nil {
			return k, nil
		}
	}
	if len(b) != KeySize {
		return nil, fmt.Errorf("key file must hold %d raw bytes or %d hex characters", KeySize, 2*KeySize)
	}
	return b, nil
}

// Encrypted is a Store that encrypts Data on Put and decrypts it on read. Rows whose Type has no
// CipherTag pass through unchanged, so plain rows still load.
type Encrypted struct {
	inner Store
	aead  cipher.AEAD
}

// New wraps inner with AES-GCM under key, which must be KeySize bytes.
func New(inner Store, key []byte) (*Encrypted, error) {
	if len(key) != KeySize {
		return nil, fmt.Errorf("key must be %d bytes, got %d", KeySize, len(key))
	}
	blk, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	g, err := cipher.NewGCM(blk)
	if err != nil {
		return nil, err
	}
	return &Encrypted{inner: inner, aead: g}, nil
}

// aad binds the ciphertext to its row so it cannot be moved to another thread, id or type.
func aad(thread, id, typ string) []byte { return []byte(thread + "\x00" + id + "\x00" + typ) }

// Put encrypts r.Data and stores it with Type tagged by CipherTag.
func (e *Encrypted) Put(ctx context.Context, r Row) error {
	r.Type = strings.TrimSuffix(r.Type, CipherTag) + CipherTag
	nonce := make([]byte, e.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	r.Data = e.aead.Seal(nonce, nonce, r.Data, aad(r.Thread, r.ID, r.Type))
	return e.inner.Put(ctx, r)
}

func (e *Encrypted) open(r Row, ok bool, err error) (Row, bool, error) {
	if err != nil || !ok || !strings.HasSuffix(r.Type, CipherTag) {
		return r, ok, err
	}
	n := e.aead.NonceSize()
	if len(r.Data) < n {
		return Row{}, false, errors.New("encrypted row shorter than its nonce")
	}
	pt, err := e.aead.Open(nil, r.Data[:n], r.Data[n:], aad(r.Thread, r.ID, r.Type))
	if err != nil {
		return Row{}, false, fmt.Errorf("decrypt %s/%s: %w", r.Thread, r.ID, err)
	}
	r.Data, r.Type = pt, strings.TrimSuffix(r.Type, CipherTag)
	return r, true, nil
}

// Get returns the row at (thread, id), decrypted when it was stored encrypted.
func (e *Encrypted) Get(ctx context.Context, thread, id string) (Row, bool, error) {
	r, ok, err := e.inner.Get(ctx, thread, id)
	return e.open(r, ok, err)
}

// Latest returns the newest row in thread, decrypted when it was stored encrypted.
func (e *Encrypted) Latest(ctx context.Context, thread string) (Row, bool, error) {
	r, ok, err := e.inner.Latest(ctx, thread)
	return e.open(r, ok, err)
}

// PruneKeepLatest prunes the wrapped store.
func (e *Encrypted) PruneKeepLatest(ctx context.Context) (int, error) {
	return e.inner.PruneKeepLatest(ctx)
}

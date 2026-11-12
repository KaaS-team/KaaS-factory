// Ported from browser-use/browser-use@dfb6a73 browser_use/browser/local.py
package browsercheck

import (
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"time"
)

// TempPrefix starts the name of every temp dir a run makes; SweepStale only touches names with it.
const TempPrefix = "factory-browsercheck-"

const (
	ownerFile = ".owner"         // in each temp dir, locked while its run lives
	freshFor  = 60 * time.Second // a dir this young may belong to a run that has not locked yet
)

// skipCopy lists what Chrome rebuilds, what is large, and what the running Chrome owns.
var skipCopy = []string{"Cache",
	"Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "GrShaderCache",
	"GraphiteDawnCache", "ShaderCache", "CacheStorage", "ScriptCache", "Singleton*", "LOCK", "lockfile", "DevToolsActivePort",
}

// SkipCopy reports whether a file or dir name is left out of a profile copy.
func SkipCopy(name string) bool {
	for _, p := range skipCopy {
		if ok, _ := path.Match(p, name); ok {
			return true
		}
	}
	return false
}

// CopyProfile copies Local State and one profile directory from a Chrome user-data-dir into dst,
// without caches, lock files or the other profiles. Symlinks are copied as symlinks.
func CopyProfile(root, dir, dst string) error {
	if err := os.MkdirAll(dst, 0o700); err != nil {
		return err
	}
	if b, err := os.ReadFile(filepath.Join(root, "Local State")); err == nil {
		if err := os.WriteFile(filepath.Join(dst, "Local State"), b, 0o600); err != nil {
			return err
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	src := filepath.Join(root, dir)
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p != src && SkipCopy(d.Name()) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		to := filepath.Join(dst, rel)
		switch {
		case d.IsDir():
			return os.MkdirAll(to, 0o700)
		case d.Type()&fs.ModeSymlink != 0:
			target, err := os.Readlink(p)
			if err != nil {
				return err
			}
			return os.Symlink(target, to)
		default:
			b, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			return os.WriteFile(to, b, 0o600)
		}
	})
}

// SweepStale deletes temp dirs left in root by runs that died without cleaning up (SIGKILL, OOM, a
// crash): a profile copy holds the user's cookies. A dir whose owner still runs stays locked, a dir
// younger than a minute is skipped, and a dir with no owner file is not ours to judge.
func SweepStale(root string, now time.Time) {
	dirs, _ := filepath.Glob(filepath.Join(root, TempPrefix+"*"))
	for _, d := range dirs {
		st, err := os.Stat(filepath.Join(d, ownerFile))
		if err != nil || now.Sub(st.ModTime()) < freshFor {
			continue
		}
		f, err := os.OpenFile(filepath.Join(d, ownerFile), os.O_RDWR, 0)
		if err != nil {
			continue
		}
		locked := tryLock(f)
		_ = f.Close()
		if locked {
			_ = os.RemoveAll(d)
		}
	}
}

// workDir makes a locked temp dir under root and returns it with a func that unlocks and removes it.
func workDir(root string) (string, func(), error) {
	d, err := os.MkdirTemp(root, TempPrefix)
	if err != nil {
		return "", nil, err
	}
	f, err := os.Create(filepath.Join(d, ownerFile))
	if err != nil {
		_ = os.RemoveAll(d)
		return "", nil, err
	}
	tryLock(f)
	return d, func() { _ = f.Close(); _ = os.RemoveAll(d) }, nil
}

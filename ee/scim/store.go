//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package scim

import (
	"errors"
	"sort"
	"sync"
)

// Errors a Store returns; the handler maps them to 404 and 409.
var (
	ErrNotFound = errors.New("scim: not found")
	ErrConflict = errors.New("scim: already exists")
)

// User is a provisioned person. UserName is lower case and unique.
type User struct {
	ID         string
	UserName   string
	ExternalID string
	Active     bool
}

// Group is a named set of user ids. DisplayName is unique.
type Group struct {
	ID          string
	DisplayName string
	Members     []string
}

// Store persists SCIM users and groups. Create returns ErrConflict on a taken UserName or
// DisplayName; Get, Update and Delete return ErrNotFound for an unknown id.
type Store interface {
	CreateUser(User) error
	GetUser(id string) (User, error)
	// ListUsers returns users ordered by UserName; a non-empty userName narrows to that one.
	ListUsers(userName string) ([]User, error)
	UpdateUser(User) error
	DeleteUser(id string) error
	CreateGroup(Group) error
	GetGroup(id string) (Group, error)
	// ListGroups returns groups ordered by DisplayName; a non-empty displayName narrows to that one.
	ListGroups(displayName string) ([]Group, error)
	UpdateGroup(Group) error
	DeleteGroup(id string) error
}

// MemoryStore is a Store held in memory, for tests and single-process use.
type MemoryStore struct {
	mu     sync.Mutex
	users  map[string]User
	groups map[string]Group
}

// NewMemoryStore returns an empty MemoryStore.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{users: map[string]User{}, groups: map[string]Group{}}
}

// CreateUser adds a user, refusing a duplicate UserName.
func (m *MemoryStore) CreateUser(u User) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, o := range m.users {
		if o.UserName == u.UserName {
			return ErrConflict
		}
	}
	m.users[u.ID] = u
	return nil
}

// GetUser returns the user with the id.
func (m *MemoryStore) GetUser(id string) (User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.users[id]
	if !ok {
		return User{}, ErrNotFound
	}
	return u, nil
}

// ListUsers returns users ordered by UserName, or the one named.
func (m *MemoryStore) ListUsers(userName string) ([]User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []User
	for _, u := range m.users {
		if userName == "" || u.UserName == userName {
			out = append(out, u)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UserName < out[j].UserName })
	return out, nil
}

// UpdateUser replaces the user with the same id.
func (m *MemoryStore) UpdateUser(u User) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.users[u.ID]; !ok {
		return ErrNotFound
	}
	m.users[u.ID] = u
	return nil
}

// DeleteUser removes the user with the id.
func (m *MemoryStore) DeleteUser(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.users[id]; !ok {
		return ErrNotFound
	}
	delete(m.users, id)
	return nil
}

// CreateGroup adds a group, refusing a duplicate DisplayName.
func (m *MemoryStore) CreateGroup(g Group) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, o := range m.groups {
		if o.DisplayName == g.DisplayName {
			return ErrConflict
		}
	}
	m.groups[g.ID] = g
	return nil
}

// GetGroup returns the group with the id.
func (m *MemoryStore) GetGroup(id string) (Group, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	g, ok := m.groups[id]
	if !ok {
		return Group{}, ErrNotFound
	}
	return g, nil
}

// ListGroups returns groups ordered by DisplayName, or the one named.
func (m *MemoryStore) ListGroups(displayName string) ([]Group, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Group
	for _, g := range m.groups {
		if displayName == "" || g.DisplayName == displayName {
			out = append(out, g)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DisplayName < out[j].DisplayName })
	return out, nil
}

// UpdateGroup replaces the group with the same id.
func (m *MemoryStore) UpdateGroup(g Group) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.groups[g.ID]; !ok {
		return ErrNotFound
	}
	m.groups[g.ID] = g
	return nil
}

// DeleteGroup removes the group with the id.
func (m *MemoryStore) DeleteGroup(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.groups[id]; !ok {
		return ErrNotFound
	}
	delete(m.groups, id)
	return nil
}

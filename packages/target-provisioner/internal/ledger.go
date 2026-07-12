package internal

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// LedgerEntry is one installed JIT public key.
type LedgerEntry struct {
	KeyID        string            `json:"keyId"`
	JobID        string            `json:"jobId"`
	PublicKey    string            `json:"publicKey"`
	FilePath     string            `json:"filePath"`
	ForcedCmd    string            `json:"forcedCommand"`
	Environment  map[string]string `json:"environment,omitempty"`
	SingleUse    bool              `json:"singleUse"`
	MaxSessions  int               `json:"maxSessions"`
	SessionsUsed int               `json:"sessionsUsed"`
	CreatedAt    time.Time         `json:"createdAt"`
	ExpiresAt    time.Time         `json:"expiresAt"`
}

type ledgerFile struct {
	Entries []LedgerEntry `json:"entries"`
}

// Ledger is an append-friendly JSON file of active keys (mutex-protected).
type Ledger struct {
	path string
	mu   sync.Mutex
}

func NewLedger(path string) *Ledger {
	return &Ledger{path: path}
}

func (l *Ledger) load() ([]LedgerEntry, error) {
	data, err := os.ReadFile(l.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	if len(data) == 0 {
		return nil, nil
	}
	var f ledgerFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("ledger corrupt: %w", err)
	}
	return f.Entries, nil
}

func (l *Ledger) save(entries []LedgerEntry) error {
	if err := os.MkdirAll(filepath.Dir(l.path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(ledgerFile{Entries: entries}, "", "  ")
	if err != nil {
		return err
	}
	tmp := l.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, l.path)
}

// Active returns non-expired entries (does not mutate).
func (l *Ledger) Active(now time.Time) ([]LedgerEntry, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	all, err := l.load()
	if err != nil {
		return nil, err
	}
	out := make([]LedgerEntry, 0, len(all))
	for _, e := range all {
		if e.ExpiresAt.After(now) {
			out = append(out, e)
		}
	}
	return out, nil
}

// CountActiveForJob returns active keys for jobId where sessionsUsed < maxSessions.
func (l *Ledger) CountActiveForJob(jobID string, now time.Time) (int, error) {
	active, err := l.Active(now)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, e := range active {
		if e.JobID == jobID && e.SessionsUsed < e.MaxSessions {
			n++
		}
	}
	return n, nil
}

// Add appends an entry.
func (l *Ledger) Add(e LedgerEntry) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	all, err := l.load()
	if err != nil {
		return err
	}
	all = append(all, e)
	return l.save(all)
}

// Remove deletes by jobId+keyId and returns the removed entry (if any).
func (l *Ledger) Remove(jobID, keyID string) (*LedgerEntry, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	all, err := l.load()
	if err != nil {
		return nil, err
	}
	var removed *LedgerEntry
	kept := make([]LedgerEntry, 0, len(all))
	for _, e := range all {
		if e.JobID == jobID && e.KeyID == keyID {
			cp := e
			removed = &cp
			continue
		}
		kept = append(kept, e)
	}
	if removed == nil {
		return nil, nil
	}
	if err := l.save(kept); err != nil {
		return nil, err
	}
	return removed, nil
}

// PurgeExpired removes expired entries and returns them (caller deletes files).
func (l *Ledger) PurgeExpired(now time.Time) ([]LedgerEntry, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	all, err := l.load()
	if err != nil {
		return nil, err
	}
	var expired []LedgerEntry
	kept := make([]LedgerEntry, 0, len(all))
	for _, e := range all {
		if !e.ExpiresAt.After(now) {
			expired = append(expired, e)
			continue
		}
		kept = append(kept, e)
	}
	if len(expired) == 0 {
		return nil, nil
	}
	if err := l.save(kept); err != nil {
		return nil, err
	}
	return expired, nil
}

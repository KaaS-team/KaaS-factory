package mergeq

// Halve splits a failed batch into two child batches: the first floor(N/2) entries and the rest. A
// batch of one cannot be split, so ok is false and the entry is the culprit. The rule is bors-ng's
// batch divider, ported as logic.
func Halve(batch []Entry) (lo, hi []Entry, ok bool) {
	if len(batch) < 2 {
		return nil, nil, false
	}
	n := len(batch) / 2
	return batch[:n], batch[n:], true
}

// Take returns the next batch from the live queue: at most size entries, stopping before an entry
// marked Single, which only ever goes alone.
func Take(live []Entry, size int) []Entry {
	if len(live) > 0 && live[0].Single {
		return live[:1]
	}
	n := min(size, len(live))
	for i := 1; i < n; i++ {
		if live[i].Single {
			return live[:i]
		}
	}
	return live[:n]
}

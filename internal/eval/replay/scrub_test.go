package replay

import "testing"

func TestStabilizeRules(t *testing.T) {
	long := "sha256:beefdbd8a1da6d2915566fde36db9db0b524eb737fc57cd1367effd16dc0d06d"
	cases := []struct{ name, in, want string }{
		{"sha256 digest", "pull alpine@" + long, "pull alpine@sha256:" + xs(64)},
		{"xxh3 digest", "id xxh3:0724b85200c28a1d", "id xxh3:" + xs(16)},
		{"byte size", "wrote 9.3 kB", "wrote X.X B"},
		{"bytes word", "1048576000 bytes", "XX bytes"},
		{"duration short", "took 4.063ms", "took X.Xs"},
		{"duration compound", "took 1m2.345s", "took X.Xs"},
		{"duration words", "4.063 seconds", "X.X seconds"},
		{"clock time", "at 12:34:56", "at XX:XX:XX"},
		{"iso date", "on 2024-09-12", "on 20XX-XX-XX"},
		{"iso timestamp", "2024-09-25T20:47:16.793Z", "XXXX-XX-XXTXX:XX:XX.XXXZ"},
		{"datetime", "2024-09-12 10:02:03.4567", "20XX-XX-XX XX:XX:XX.XXXX"},
		{"localhost port", "listening on 127.0.0.1:54321", "listening on 127.0.0.1:XXXXX"},
		{"host port", "http://localhost:8080/x", "http://localhost:XXXXX/x"},
		{"port word", "port 41999 ready", "port XXXXX ready"},
		{"private ip", "peer 10.89.0.8", "peer 10.XX.XX.XX"},
		{"pid", "pid=4242", "pid=X"},
		{"hex address", "at 0x7f80cbe716c0", "at 0xXXXXXXXXXXXX"},
		{"trailing space", "foo \nbar", "foo\nbar"},
		{"stable text", "hello world", "hello world"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Stabilize(c.in); got != c.want {
				t.Fatalf("Stabilize(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestStabilizeIsIdempotent(t *testing.T) {
	in := "took 3.2s at 12:00:01 on 127.0.0.1:9999 sha256:" + xs(64)
	once := Stabilize(in)
	if twice := Stabilize(once); twice != once {
		t.Fatalf("not idempotent: %q then %q", once, twice)
	}
}

func xs(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = 'X'
	}
	return string(b)
}

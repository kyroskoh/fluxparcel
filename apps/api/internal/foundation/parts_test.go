package foundation

import "testing"

func TestChoosePartSize(t *testing.T) {
	const mib = 1 << 20
	cases := []struct {
		name                      string
		fileSize, requested, want int64
		configured                int64
		fails                     bool
	}{
		{name: "default", fileSize: 100 * mib, configured: DefaultPartSize, want: DefaultPartSize},
		{name: "configured larger default", fileSize: 100 * mib, configured: 32 * mib, want: 32 * mib},
		{name: "client request", fileSize: 100 * mib, requested: 16 * mib, configured: DefaultPartSize, want: 16 * mib},
		{name: "64 GiB fits default", fileSize: 64 << 30, configured: DefaultPartSize, want: DefaultPartSize},
		{name: "raised to stay under the part limit", fileSize: 100 << 30, configured: DefaultPartSize, want: 11 * mib},
		{name: "too small", fileSize: mib, requested: 4 * mib, configured: DefaultPartSize, fails: true},
		{name: "too large", fileSize: mib, requested: 65 * mib, configured: DefaultPartSize, fails: true},
		{name: "not whole MiB", fileSize: mib, requested: 8*mib + 1, configured: DefaultPartSize, fails: true},
		{name: "beyond the part limit", fileSize: 700 << 30, configured: DefaultPartSize, fails: true},
	}
	for _, test := range cases {
		got, err := choosePartSize(test.fileSize, test.requested, test.configured)
		if test.fails != (err != nil) || (!test.fails && got != test.want) {
			t.Errorf("%s: got %d, %v; want %d, fails %v", test.name, got, err, test.want, test.fails)
		}
		if !test.fails && (test.fileSize+got-1)/got > maxParts {
			t.Errorf("%s: %d parts exceed the limit", test.name, (test.fileSize+got-1)/got)
		}
	}
}

// A transfer keeps the part size it was created with, so changing the default never changes its part boundaries.
func TestPartLengthUsesTheTransfersOwnSize(t *testing.T) {
	const mib = 1 << 20
	if got := partLength(20*mib, 8*mib, 3); got != 4*mib {
		t.Fatalf("last 8 MiB part: %d", got)
	}
	if got := partLength(20*mib, 16*mib, 2); got != 4*mib {
		t.Fatalf("last 16 MiB part: %d", got)
	}
}

func TestByteBudget(t *testing.T) {
	budget := &byteBudget{limit: 16}
	if !budget.acquire(10) || budget.acquire(10) {
		t.Fatal("budget admitted more than its limit")
	}
	budget.release(10)
	if !budget.acquire(16) {
		t.Fatal("budget did not free released bytes")
	}
}

// Ported from temporalio/temporal@bfabec7 common/backoff/retrypolicy.go

package retry

import (
	"math"
	"math/rand/v2"
	"time"
)

const (
	// NoInterval means no maximum interval and no expiration.
	NoInterval        = 0
	done              = time.Duration(-1)
	noMaximumAttempts = 0

	defaultBackoffCoefficient = 2.0
	defaultMaximumInterval    = 10 * time.Second
	defaultExpirationInterval = time.Minute
)

// Done is the delay a RetryPolicy returns to say the operation must not be tried again.
const Done = done

// RetryPolicy decides how long to wait before the next attempt, or returns Done.
type RetryPolicy interface {
	ComputeNextDelay(elapsedTime time.Duration, numAttempts int, err error) time.Duration
}

// Retrier holds the attempt count and start time of one retry sequence.
type Retrier struct {
	policy         RetryPolicy
	now            func() time.Time
	currentAttempt int
	startTime      time.Time
}

// ExponentialRetryPolicy waits min(initialInterval * coefficient^(attempt-1), maximumInterval) with jitter.
type ExponentialRetryPolicy struct {
	initialInterval    time.Duration
	backoffCoefficient float64
	maximumInterval    time.Duration
	expirationInterval time.Duration
	maximumAttempts    int
}

// NewExponentialRetryPolicy returns a policy with the given first interval, coefficient 2, a 10s
// maximum interval, a one minute expiration and no attempt limit.
func NewExponentialRetryPolicy(initialInterval time.Duration) *ExponentialRetryPolicy {
	return &ExponentialRetryPolicy{
		initialInterval:    initialInterval,
		backoffCoefficient: defaultBackoffCoefficient,
		maximumInterval:    defaultMaximumInterval,
		expirationInterval: defaultExpirationInterval,
		maximumAttempts:    noMaximumAttempts,
	}
}

// NewRetrier starts a retry sequence that reads time from now.
func NewRetrier(policy RetryPolicy, now func() time.Time) *Retrier {
	return &Retrier{policy: policy, now: now, startTime: now(), currentAttempt: 1}
}

// WithMaximumInterval caps one wait; it does not stop retrying (WithExpirationInterval does).
func (p *ExponentialRetryPolicy) WithMaximumInterval(maximumInterval time.Duration) *ExponentialRetryPolicy {
	p.maximumInterval = maximumInterval
	return p
}

// WithExpirationInterval stops retrying once this much time has passed since the first attempt.
func (p *ExponentialRetryPolicy) WithExpirationInterval(expirationInterval time.Duration) *ExponentialRetryPolicy {
	p.expirationInterval = expirationInterval
	return p
}

// WithMaximumAttempts sets the total number of attempts allowed, the first one included; 0 is no limit.
func (p *ExponentialRetryPolicy) WithMaximumAttempts(maximumAttempts int) *ExponentialRetryPolicy {
	p.maximumAttempts = maximumAttempts
	return p
}

// ComputeNextDelay returns the wait before attempt numAttempts+1, or Done.
func (p *ExponentialRetryPolicy) ComputeNextDelay(elapsedTime time.Duration, numAttempts int, _ error) time.Duration {
	// With maximumAttempts X, stop when numAttempts == X, otherwise there would be an attempt X+1.
	if p.maximumAttempts != noMaximumAttempts && numAttempts >= p.maximumAttempts {
		return done
	}
	if p.expirationInterval != NoInterval && elapsedTime > p.expirationInterval {
		return done
	}

	nextInterval := float64(p.initialInterval) * math.Pow(p.backoffCoefficient, float64(numAttempts-1))
	// Disallow retries if initialInterval is negative.
	if nextInterval <= 0 {
		return done
	}
	if p.maximumInterval != NoInterval {
		nextInterval = math.Min(nextInterval, float64(p.maximumInterval))
	}
	if p.expirationInterval != NoInterval {
		remainingTime := math.Max(0, float64(p.expirationInterval-elapsedTime))
		nextInterval = math.Min(remainingTime, nextInterval)
	}

	// An out-of-range float64 to int64 conversion wraps on amd64 but saturates on arm64, so stop here.
	if nextInterval >= float64(math.MaxInt64) {
		return done
	}
	// Bail out if the next interval is smaller than the initial retry interval.
	if time.Duration(nextInterval) < p.initialInterval {
		return done
	}
	return time.Duration(addJitter(nextInterval))
}

func addJitter(nextInterval float64) float64 {
	// Jitter avoids global synchronization: the wait lands in [0.8x, x).
	jitterPortion := max(int(0.2*nextInterval), 1) // at least 1 to prevent overflow in IntN
	return nextInterval*0.8 + float64(rand.IntN(jitterPortion))
}

// NextBackOff returns the wait before the next attempt, or Done, and counts the attempt.
func (r *Retrier) NextBackOff(err error) time.Duration {
	next := r.policy.ComputeNextDelay(r.now().Sub(r.startTime), r.currentAttempt, err)
	r.currentAttempt++
	return next
}

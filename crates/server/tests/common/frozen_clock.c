/* Test-only host-binary clock injection. Monotonic timers always use libc. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <sys/time.h>
#include <time.h>

int clock_gettime(clockid_t clock, struct timespec *value) {
    if (clock == CLOCK_REALTIME || clock == CLOCK_REALTIME_COARSE) {
        value->tv_sec = 1768478400;
        value->tv_nsec = 0;
        return 0;
    }
    int (*real_clock_gettime)(clockid_t, struct timespec *) = dlsym(RTLD_NEXT, "clock_gettime");
    return real_clock_gettime(clock, value);
}

int gettimeofday(struct timeval *value, void *timezone) {
    (void)timezone;
    value->tv_sec = 1768478400;
    value->tv_usec = 0;
    return 0;
}

time_t time(time_t *value) {
    if (value) *value = 1768478400;
    return 1768478400;
}

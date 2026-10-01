#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <math.h>
#include <pthread.h>
#include <time.h>
#include <ctype.h>
static volatile long sink;
long b_malloc(int n) { for (int i = 0; i < n; i++) { void* p = malloc(16 + (i & 1023)); sink += (long)p; free(p); } return sink; }
long b_malloc_hold(int n) { void* ps[256]; for (int i = 0; i < n; i++) { int k = i & 255; if (i >= 256) free(ps[k]); ps[k] = malloc(32 + (i * 7 & 511)); } for (int k = 0; k < 256 && k < n; k++) free(ps[k]); return n; }
long b_snprintf(int n) { char buf[96]; long t = 0; for (int i = 0; i < n; i++) t += snprintf(buf, sizeof buf, "%d:%s:%.3f:%x", i, "abc", i * 0.25, i); return t; }
long b_strtod(int n) { long t = 0; const char* s[] = {"3.14159", "1e-7", "-2.5e10", "12345.678"}; for (int i = 0; i < n; i++) t += (long)strtod(s[i & 3], 0); return t; }
long b_memcpy(int n) { static char a[4096], b[4096]; for (int i = 0; i < n; i++) { memcpy(a + (i & 15), b, 256 + (i & 255)); } return a[7]; }
long b_strlen(int n) { static char s[200]; memset(s, 'x', 150); long t = 0; for (int i = 0; i < n; i++) t += strlen(s + (i & 63)); return t; }
long b_mutex(int n) { static pthread_mutex_t m = PTHREAD_MUTEX_INITIALIZER; for (int i = 0; i < n; i++) { pthread_mutex_lock(&m); sink++; pthread_mutex_unlock(&m); } return sink; }
long b_clock(int n) { struct timespec ts; long t = 0; for (int i = 0; i < n; i++) { clock_gettime(CLOCK_MONOTONIC, &ts); t += ts.tv_nsec; } return t; }
long b_sin(int n) { double t = 0; for (int i = 0; i < n; i++) t += sin(i * 0.001) + exp(i * 1e-6); return (long)t; }
long b_tls(int n) { static pthread_key_t k; static int once; if (!once) { pthread_key_create(&k, 0); once = 1; } for (int i = 0; i < n; i++) { pthread_setspecific(k, (void*)(long)i); sink += (long)pthread_getspecific(k); } return sink; }
long b_qsort_cmp(const void* a, const void* b) { return *(const int*)a - *(const int*)b; }
int cmp(const void* a, const void* b) { return *(const int*)a - *(const int*)b; }
long b_qsort(int n) { static int v[1000]; for (int r = 0; r < n; r++) { for (int i = 0; i < 1000; i++) v[i] = (i * 7919 + r) % 1000; qsort(v, 1000, sizeof(int), cmp); } return v[500]; }
long b_ctype(int n) { long t = 0; for (int i = 0; i < n; i++) t += isalpha(i & 127) + isdigit(i & 127) + toupper(i & 127); return t; }

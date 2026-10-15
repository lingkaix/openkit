/* Native counterfactual for the App release gate. Suppress only the address-space
 * setter; the unchanged product smoke must then report an unlimited AS limit.
 * This library is mounted only into the disposable negative fixture container.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <sys/resource.h>

int setrlimit(__rlimit_resource_t resource, const struct rlimit *limit) {
  if (resource == RLIMIT_AS) return 0;
  int (*real_setrlimit)(__rlimit_resource_t, const struct rlimit *) =
      dlsym(RTLD_NEXT, "setrlimit");
  return real_setrlimit(resource, limit);
}

int setrlimit64(__rlimit_resource_t resource, const struct rlimit64 *limit) {
  if (resource == RLIMIT_AS) return 0;
  int (*real_setrlimit64)(__rlimit_resource_t, const struct rlimit64 *) =
      dlsym(RTLD_NEXT, "setrlimit64");
  return real_setrlimit64(resource, limit);
}

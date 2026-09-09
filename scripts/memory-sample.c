#include <errno.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>

int main(int argc, char **argv) {
  if (argc < 2 || argc > 129) return 2;
  printf("[");
  for (int i = 1; i < argc; i++) {
    char *end;
    errno = 0;
    long pid = strtol(argv[i], &end, 10);
    if (errno || *end || pid < 1 || pid > 2147483647) return 2;
    struct rusage_info_v4 info = {0};
    int result = proc_pid_rusage((int)pid, RUSAGE_INFO_V4, (rusage_info_t *)&info);
    if (i > 1) printf(",");
    if (result != 0) {
      printf("{\"pid\":%ld,\"error\":%d}", pid, errno);
    } else {
      char name[256] = {0};
      proc_name((int)pid, name, sizeof(name));
      printf("{\"pid\":%ld,\"name\":\"", pid);
      for (size_t j = 0; name[j]; j++) {
        unsigned char c = (unsigned char)name[j];
        if (c < 32 || c >= 127 || c == '"' || c == '\\') printf("\\u%04x", c);
        else putchar(c);
      }
      printf("\",\"rssBytes\":%llu,\"physicalFootprintBytes\":%llu,\"peakPhysicalFootprintBytes\":%llu}",
        (unsigned long long)info.ri_resident_size,
        (unsigned long long)info.ri_phys_footprint,
        (unsigned long long)info.ri_lifetime_max_phys_footprint);
    }
  }
  printf("]\n");
  return 0;
}

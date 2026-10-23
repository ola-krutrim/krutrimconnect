// SPDX-License-Identifier: Apache-2.0
// Linux open-file-description locks: released by the kernel when the last fd closes.
#define _GNU_SOURCE
#include <node_api.h>
#include <fcntl.h>
#include <errno.h>
#include <string.h>
#include <unistd.h>

static napi_value lock_call(napi_env env, napi_callback_info info, short type) {
  size_t argc = 1;
  napi_value args[1], result;
  int32_t fd;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, args[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, NULL, "Expected an open file descriptor.");
    return NULL;
  }
  struct flock request = { .l_type = type, .l_whence = SEEK_SET, .l_start = 0, .l_len = 0 };
  int status;
  do { status = fcntl(fd, F_OFD_SETLK, &request); } while (status == -1 && errno == EINTR);
  if (status == -1 && errno != EAGAIN && errno != EACCES) {
    napi_throw_error(env, NULL, strerror(errno));
    return NULL;
  }
  napi_get_boolean(env, status == 0, &result);
  return result;
}
static napi_value try_lock(napi_env env, napi_callback_info info) { return lock_call(env, info, F_WRLCK); }
static napi_value unlock(napi_env env, napi_callback_info info) { return lock_call(env, info, F_UNLCK); }
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"tryLock", NULL, try_lock, NULL, NULL, NULL, napi_default, NULL},
    {"unlock", NULL, unlock, NULL, NULL, NULL, napi_default, NULL}
  };
  napi_define_properties(env, exports, 2, methods);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)

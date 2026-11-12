// Starts Node (nodejs-mobile's libnode.so) inside the app and sends its
// stdout / stderr to logcat (tag "varuna-node").
#include <jni.h>
#include <cstdlib>
#include <cstring>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>
#include "node.h"

static int pipe_stdout[2];
static int pipe_stderr[2];
static pthread_t thread_stdout;
static pthread_t thread_stderr;
static const char *TAG = "varuna-node";

static void *forward(void *arg) {
    int fd = ((int *) arg)[0];
    int prio = (arg == pipe_stderr) ? ANDROID_LOG_ERROR : ANDROID_LOG_INFO;
    char buf[2048];
    ssize_t n;
    while ((n = read(fd, buf, sizeof buf - 1)) > 0) {
        if (buf[n - 1] == '\n') --n;
        buf[n] = 0;
        __android_log_write(prio, TAG, buf);
    }
    return nullptr;
}

static void redirect_output() {
    setvbuf(stdout, nullptr, _IONBF, 0);
    if (pipe(pipe_stdout) == 0) {
        dup2(pipe_stdout[1], STDOUT_FILENO);
        if (pthread_create(&thread_stdout, nullptr, forward, pipe_stdout) == 0) pthread_detach(thread_stdout);
    }
    setvbuf(stderr, nullptr, _IONBF, 0);
    if (pipe(pipe_stderr) == 0) {
        dup2(pipe_stderr[1], STDERR_FILENO);
        if (pthread_create(&thread_stderr, nullptr, forward, pipe_stderr) == 0) pthread_detach(thread_stderr);
    }
}

extern "C" JNIEXPORT jint JNICALL
Java_ai_varuna_gcs_NodeRunner_startNodeWithArguments(JNIEnv *env, jclass, jobjectArray arguments) {
    jsize argc = env->GetArrayLength(arguments);

    // libuv wants argv as one contiguous block.
    size_t total = 0;
    for (jsize i = 0; i < argc; i++) {
        auto s = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *c = env->GetStringUTFChars(s, nullptr);
        total += strlen(c) + 1;
        env->ReleaseStringUTFChars(s, c);
        env->DeleteLocalRef(s);
    }
    char *block = (char *) calloc(total, sizeof(char));
    char **argv = (char **) calloc((size_t) argc + 1, sizeof(char *));
    char *at = block;
    for (jsize i = 0; i < argc; i++) {
        auto s = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *c = env->GetStringUTFChars(s, nullptr);
        size_t len = strlen(c);
        memcpy(at, c, len);
        argv[i] = at;
        at += len + 1;
        env->ReleaseStringUTFChars(s, c);
        env->DeleteLocalRef(s);
    }

    redirect_output();
    return (jint) node::Start(argc, argv);
}

cmake_minimum_required(VERSION 3.18)
project(varunacam C)

# The USB webcam's video transfers (isochronous), which Java can't do.
add_library(uvcstream SHARED uvc_stream.c)
target_link_libraries(uvcstream log)

cmake_minimum_required(VERSION 3.15)
project(kirby_native)

include_directories(${CMAKE_JS_INC})

set(SOURCE_FILES
  src/addon.mm
  src/kirby_window.mm
  src/drag_handler.mm
  src/snap_engine.mm
  src/animator.mm
)

add_library(${PROJECT_NAME} SHARED ${SOURCE_FILES})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")
target_link_libraries(${PROJECT_NAME} ${CMAKE_JS_LIB})

# node-addon-api include path
execute_process(
  COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
target_include_directories(${PROJECT_NAME} PRIVATE ${NODE_ADDON_API_DIR})

# macOS frameworks + ARC
if(APPLE)
  target_compile_options(${PROJECT_NAME} PRIVATE -fobjc-arc)
  target_link_libraries(${PROJECT_NAME}
    "-framework AppKit"
    "-framework Foundation"
    "-framework CoreGraphics"
    "-framework QuartzCore"
    "-framework WebKit"
  )
  set_target_properties(${PROJECT_NAME} PROPERTIES
    LINK_FLAGS "-ObjC"
    MACOSX_DEPLOYMENT_TARGET "13.0"
  )
endif()

add_definitions(-DNAPI_VERSION=8 -DNAPI_DISABLE_CPP_EXCEPTIONS)

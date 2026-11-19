#import <AppKit/AppKit.h>
#include <stdint.h>

int64_t mac_pasteboard_change_count(void) {
    @autoreleasepool {
        return (int64_t)[[NSPasteboard generalPasteboard] changeCount];
    }
}

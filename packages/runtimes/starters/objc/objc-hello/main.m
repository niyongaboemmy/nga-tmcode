#import <Foundation/Foundation.h>

int main(void)
{
    @autoreleasepool {
        NSString *greeting = @"Hello, world!";
        printf("%s\n", [greeting UTF8String]);
    }
    return 0;
}

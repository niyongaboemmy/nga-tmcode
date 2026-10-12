#import <Foundation/Foundation.h>

int main(void)
{
    @autoreleasepool {
        // Read one line with two whole numbers, e.g. "3 4".
        long a = 0, b = 0;
        if (scanf("%ld %ld", &a, &b) != 2) {
            printf("Please enter two whole numbers\n");
            return 1;
        }
        NSNumber *sum = @(a + b);
        printf("Sum: %s\n", [[sum stringValue] UTF8String]);
    }
    return 0;
}

#include <stdio.h>
#include "list.h"

int main(void) {
    Node *list = NULL;
    for (int i = 1; i <= 5; i++) list = list_push(list, i * i);
    list_print(list);
    printf("Length: %d, sum: %d\n", list_length(list), list_sum(list));
    list_free(list);
    return 0;
}

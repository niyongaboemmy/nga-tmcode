#include <stdio.h>
#include <stdlib.h>
#include "list.h"

Node *list_push(Node *head, int value) {
    Node *n = malloc(sizeof *n);
    n->value = value;
    n->next = head;
    return n;
}

void list_print(const Node *head) {
    for (const Node *p = head; p; p = p->next) printf("%d%s", p->value, p->next ? " -> " : "\n");
}

int list_length(const Node *head) {
    int n = 0;
    for (; head; head = head->next) n++;
    return n;
}

void list_free(Node *head) {
    while (head) {
        Node *next = head->next;
        free(head);
        head = next;
    }
}

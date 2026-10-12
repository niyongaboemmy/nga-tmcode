#include <stdio.h>
#include <stdlib.h>
#include "list.h"

Node *list_push(Node *head, int value) {
    Node *n = malloc(sizeof *n);
    if (!n) {
        perror("malloc");
        exit(1);
    }
    n->value = value;
    n->next = head;
    return n;
}

int list_length(const Node *head) {
    int n = 0;
    for (; head; head = head->next) n++;
    return n;
}

int list_sum(const Node *head) {
    int s = 0;
    for (; head; head = head->next) s += head->value;
    return s;
}

void list_print(const Node *head) {
    for (const Node *p = head; p; p = p->next) printf("%d%s", p->value, p->next ? " -> " : "");
    printf("\n");
}

void list_free(Node *head) {
    while (head) {
        Node *next = head->next;
        free(head);
        head = next;
    }
}

#ifndef LIST_H
#define LIST_H

/* A singly linked list of ints. */
typedef struct Node {
    int value;
    struct Node *next;
} Node;

Node *list_push(Node *head, int value);
int list_length(const Node *head);
int list_sum(const Node *head);
void list_print(const Node *head);
void list_free(Node *head);

#endif

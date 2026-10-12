#ifndef LIST_H
#define LIST_H

typedef struct Node {
    int value;
    struct Node *next;
} Node;

Node *list_push(Node *head, int value);
void list_print(const Node *head);
int list_length(const Node *head);
void list_free(Node *head);

#endif

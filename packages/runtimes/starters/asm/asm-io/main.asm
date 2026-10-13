; x86-64 Linux, NASM syntax. The C library starts the program at main.
        default rel
        global  main
        extern  scanf, printf

        section .rodata
format_in:  db  "%ld %ld", 0
format_out: db  "Sum: %ld", 10, 0

        section .bss
a:      resq    1
b:      resq    1

        section .text
main:
        push    rbp                     ; keeps the stack 16-byte aligned for calls

        ; Read one line with two whole numbers, e.g. "3 4".
        lea     rdi, [format_in]
        lea     rsi, [a]
        lea     rdx, [b]
        xor     eax, eax                ; no vector registers used
        call    scanf

        mov     rsi, [a]                ; rsi = a + b
        add     rsi, [b]
        lea     rdi, [format_out]
        xor     eax, eax
        call    printf

        xor     eax, eax                ; return 0
        pop     rbp
        ret

        section .note.GNU-stack noalloc noexec nowrite progbits

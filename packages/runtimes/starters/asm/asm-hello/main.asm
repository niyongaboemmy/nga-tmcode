; x86-64 Linux, NASM syntax. The C library starts the program at main.
        default rel
        global  main
        extern  puts

        section .rodata
message: db      "Hello, world!", 0

        section .text
main:
        push    rbp                     ; keeps the stack 16-byte aligned for calls
        lea     rdi, [message]          ; 1st argument: the text
        call    puts
        xor     eax, eax                ; return 0
        pop     rbp
        ret

        section .note.GNU-stack noalloc noexec nowrite progbits

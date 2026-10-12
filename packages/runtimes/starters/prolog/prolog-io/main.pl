% Read one line with two whole numbers, e.g. "3 4".
main :-
    read_line_to_string(user_input, Line),
    split_string(Line, " \t", " \t", Words),
    exclude(==(""), Words, [First, Second | _]),
    number_string(A, First),
    number_string(B, Second),
    Sum is A + B,
    format("Sum: ~d~n", [Sum]).

#!/usr/bin/env escript
%% escript skips the first line, so keep the #! line above.

main(_Args) ->
    %% Read one line with two whole numbers, e.g. "3 4".
    {ok, [A, B]} = io:fread("", "~d ~d"),
    io:format("Sum: ~p~n", [A + B]).

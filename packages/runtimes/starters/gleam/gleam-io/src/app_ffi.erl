%% Reads one line from standard input as a Gleam String ("" at the end of input).
-module(app_ffi).
-export([read_line/0]).

read_line() ->
    case io:get_line("") of
        eof -> <<>>;
        {error, _} -> <<>>;
        Line -> unicode:characters_to_binary(Line)
    end.

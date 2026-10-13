use std.textio.all;

entity main is
end entity main;

architecture sim of main is
begin
  process
    variable input_line, output_line : line;
    variable a, b : integer;
  begin
    -- Read one line with two whole numbers, e.g. "3 4".
    readline(input, input_line);
    read(input_line, a);
    read(input_line, b);
    write(output_line, string'("Sum: "));
    write(output_line, a + b);
    writeln(output, output_line);
    wait;
  end process;
end architecture sim;

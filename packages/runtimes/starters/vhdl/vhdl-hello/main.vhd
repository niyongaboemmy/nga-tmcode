use std.textio.all;

entity main is
end entity main;

architecture sim of main is
begin
  process
    variable l : line;
  begin
    write(l, string'("Hello, world!"));
    writeln(output, l);
    wait;
  end process;
end architecture sim;

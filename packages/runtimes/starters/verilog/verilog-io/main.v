module main;
  integer a, b, count;

  initial begin
    // Read one line with two whole numbers, e.g. "3 4".
    // 32'h8000_0000 is standard input.
    count = $fscanf(32'h8000_0000, "%d %d", a, b);
    $display("Sum: %0d", a + b);
  end
endmodule

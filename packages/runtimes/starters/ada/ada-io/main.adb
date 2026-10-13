with Ada.Text_IO;         use Ada.Text_IO;
with Ada.Integer_Text_IO; use Ada.Integer_Text_IO;

procedure Main is
   A, B : Integer;
begin
   --  Read one line with two whole numbers, e.g. "3 4".
   Get (A);
   Get (B);
   Put ("Sum: ");
   Put (A + B, Width => 0);
   New_Line;
end Main;

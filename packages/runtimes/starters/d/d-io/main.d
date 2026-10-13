import std.stdio;
import std.array : split;
import std.conv : to;
import std.string : strip;

void main()
{
    // Read one line with two whole numbers, e.g. "3 4".
    auto parts = readln().strip().split();
    long a = parts[0].to!long;
    long b = parts[1].to!long;
    writeln("Sum: ", a + b);
}

const std = @import("std");

pub fn main() !void {
    const stdin = std.io.getStdIn().reader();
    const stdout = std.io.getStdOut().writer();

    // Read one line with two whole numbers, e.g. "3 4".
    var buffer: [256]u8 = undefined;
    const line = (try stdin.readUntilDelimiterOrEof(&buffer, '\n')) orelse "";

    var words = std.mem.tokenizeAny(u8, line, " \t\r");
    const a = try std.fmt.parseInt(i64, words.next() orelse "0", 10);
    const b = try std.fmt.parseInt(i64, words.next() orelse "0", 10);

    try stdout.print("Sum: {d}\n", .{a + b});
}

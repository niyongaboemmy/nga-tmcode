import 'dart:io';

void main() {
  // Read one line with two whole numbers, e.g. "3 4".
  final line = stdin.readLineSync() ?? '';
  final numbers = line.trim().split(RegExp(r'\s+')).map(int.parse).toList();
  print('Sum: ${numbers[0] + numbers[1]}');
}

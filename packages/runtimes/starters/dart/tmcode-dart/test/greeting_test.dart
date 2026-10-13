import 'package:dart_app/greeting.dart';
import 'package:test/test.dart';

void main() {
  test('greets by name', () => expect(greet('Ada'), 'Hello, Ada!'));
}

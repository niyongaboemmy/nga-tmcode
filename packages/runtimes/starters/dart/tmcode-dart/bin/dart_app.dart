import 'package:dart_app/greeting.dart';

void main(List<String> args) {
  print(greet(args.isEmpty ? 'Dart' : args.first));
}

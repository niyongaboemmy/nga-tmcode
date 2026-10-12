import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_app/main.dart';

void main() {
  testWidgets('the counter goes up', (tester) async {
    await tester.pumpWidget(const MyApp());
    expect(find.text('Pressed 0 times'), findsOneWidget);
    await tester.tap(find.byType(FloatingActionButton));
    await tester.pump();
    expect(find.text('Pressed 1 times'), findsOneWidget);
  });
}

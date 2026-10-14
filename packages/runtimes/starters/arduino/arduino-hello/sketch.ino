// Blink the Uno's built-in LED (pin 13) and say hello on the Serial Monitor.

void setup() {
  Serial.begin(9600);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println("Hello, Arduino!");
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}

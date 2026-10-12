use temperature::{describe, to_fahrenheit};

fn main() {
    for c in [5.0, 21.0, 30.0] {
        println!("{c}°C = {:.1}°F ({})", to_fahrenheit(c), describe(c));
    }
}

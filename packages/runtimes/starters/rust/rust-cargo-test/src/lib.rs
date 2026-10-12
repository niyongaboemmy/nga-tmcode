/// Degrees Celsius to Fahrenheit.
pub fn to_fahrenheit(celsius: f64) -> f64 {
    celsius * 9.0 / 5.0 + 32.0
}

/// Describes a temperature in Celsius.
pub fn describe(celsius: f64) -> &'static str {
    match celsius {
        t if t < 10.0 => "cold",
        t if t < 25.0 => "mild",
        _ => "hot",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boiling_point() {
        assert_eq!(to_fahrenheit(100.0), 212.0);
    }
}

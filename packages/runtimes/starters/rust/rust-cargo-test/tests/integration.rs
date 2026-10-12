use temperature::describe;

#[test]
fn describes_kigali_weather() {
    assert_eq!(describe(22.0), "mild");
    assert_eq!(describe(31.0), "hot");
}

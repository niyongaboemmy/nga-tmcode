use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).expect("read input");
    let numbers: Vec<f64> = input.split_whitespace().filter_map(|w| w.parse().ok()).collect();
    if numbers.is_empty() {
        println!("No numbers");
        return;
    }
    let sum: f64 = numbers.iter().sum();
    println!("Count: {}", numbers.len());
    println!("Average: {:.2}", sum / numbers.len() as f64);
}

(* Read one line with two whole numbers, e.g. "3 4". *)
let () = Scanf.scanf " %d %d" (fun a b -> Printf.printf "Sum: %d\n" (a + b))

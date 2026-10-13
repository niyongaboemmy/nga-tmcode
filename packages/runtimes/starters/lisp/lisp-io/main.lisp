;; Read one line with two whole numbers, e.g. "3 4".
(let* ((a (read))
       (b (read)))
  (format t "Sum: ~a~%" (+ a b)))

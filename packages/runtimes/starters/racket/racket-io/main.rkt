#lang racket/base

;; Read one line with two whole numbers, e.g. "3 4".
(define a (read))
(define b (read))
(printf "Sum: ~a\n" (+ a b))

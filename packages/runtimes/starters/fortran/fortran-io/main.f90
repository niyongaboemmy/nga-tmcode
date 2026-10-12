program sum_two
  implicit none
  integer(kind=8) :: a, b

  ! Read one line with two whole numbers, e.g. "3 4".
  read (*, *) a, b
  print '(a, i0)', 'Sum: ', a + b
end program sum_two

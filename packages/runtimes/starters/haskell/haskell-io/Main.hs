-- Read one line with two whole numbers, e.g. "3 4".
main :: IO ()
main = do
  line <- getLine
  let [a, b] = map read (words line) :: [Integer]
  putStrLn ("Sum: " ++ show (a + b))

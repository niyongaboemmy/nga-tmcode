(require '[clojure.string :as str])

;; Read one line with two whole numbers, e.g. "3 4".
(let [[a b] (map parse-long (str/split (str/trim (read-line)) #"\s+"))]
  (println (str "Sum: " (+ a b))))

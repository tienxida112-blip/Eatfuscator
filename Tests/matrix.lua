-- matrix: multiply, transpose, identity, 3x3 determinant
local function mat(rows, cols, f)
  local m = { rows = rows, cols = cols, v = {} }
  for i = 1, rows do
    m.v[i] = {}
    for j = 1, cols do m.v[i][j] = f(i, j) end
  end
  return m
end
local function mul(a, b)
  assert(a.cols == b.rows, "shape mismatch")
  return mat(a.rows, b.cols, function(i, j)
    local sum = 0
    for k = 1, a.cols do sum = sum + a.v[i][k] * b.v[k][j] end
    return sum
  end)
end
local function transpose(a) return mat(a.cols, a.rows, function(i, j) return a.v[j][i] end) end
local function show(m)
  local rows = {}
  for i = 1, m.rows do
    local cells = {}
    for j = 1, m.cols do cells[j] = string.format("%4d", m.v[i][j]) end
    rows[i] = table.concat(cells, " ")
  end
  return table.concat(rows, "\n")
end

local a = mat(2, 3, function(i, j) return i * 10 + j end)
local b = mat(3, 2, function(i, j) return i - j end)
print(show(a))
print(show(transpose(a)))
print(show(mul(a, b)))

local function det3(m)
  return m.v[1][1] * (m.v[2][2] * m.v[3][3] - m.v[2][3] * m.v[3][2])
    - m.v[1][2] * (m.v[2][1] * m.v[3][3] - m.v[2][3] * m.v[3][1])
    + m.v[1][3] * (m.v[2][1] * m.v[3][2] - m.v[2][2] * m.v[3][1])
end
print(det3(mat(3, 3, function(i, j) return (i * 3 + j) % 7 end)))
local id = mat(3, 3, function(i, j) return i == j and 1 or 0 end)
print(show(mul(id, mat(3, 3, function(i, j) return i + j end))))

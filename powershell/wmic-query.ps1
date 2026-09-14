$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$spec = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("__WMIC_SPEC_BASE64__")) | ConvertFrom-Json
$rows = @(
  if ($spec.condition) {
    Get-CimInstance -ClassName $spec.section -Filter $spec.condition
  } else {
    Get-CimInstance -ClassName $spec.section
  }
)

function Convert-Value([object]$value) {
  if ($null -eq $value) { return "" }
  if ($value -is [System.Array]) { return (($value | ForEach-Object { if ($null -eq $_) { "" } else { [string]$_ } }) -join ",") }
  return [string]$value
}

function Get-FieldValue([object]$row, [string]$field) {
  $property = $row.PSObject.Properties[$field]
  if ($null -eq $property) { return "" }
  return Convert-Value $property.Value
}

if ($spec.type -eq "value") {
  foreach ($row in $rows) {
    foreach ($field in $spec.fields) {
      Write-Output ($field + "=" + (Get-FieldValue $row $field))
    }
    Write-Output ""
  }
} elseif ($spec.type -eq "list") {
  foreach ($row in $rows) {
    foreach ($property in $row.CimInstanceProperties) {
      Write-Output ($property.Name + "=" + (Convert-Value $property.Value))
    }
    Write-Output ""
  }
} else {
  Write-Output ($spec.fields -join "`t")
  foreach ($row in $rows) {
    $line = @()
    foreach ($field in $spec.fields) {
      $line += (Get-FieldValue $row $field).Replace("`t", " ")
    }
    Write-Output ($line -join "`t")
  }
}

"use strict";

/*
  wmic calls must always be serialised in windows, hence the use of async.queue
*/
var MAX_WORKER_COUNT = 100;
var execFile = require('child_process').execFile,
    async = require('async'),
    iconv = require('iconv-lite');

/**
 * Need to split a command line string taking into account strings - that is, don't
 * split spaces within a string. So that 'P1 P2 "Other Param" P4' is split into 4 param strings
 * with param 3 = "Other Param" (not including quotes).
 **/
function splitter(cmd) {
  cmd = cmd.trim();

  var acc = [], inString = false, cur = "", l = cmd.length;

  for (var i = 0 ; i < l ; i++ ){
    var ch = cmd.charAt(i);
    switch(ch) {
    case '"':
      inString = !inString;
      if (!inString) {
        if (cur.length > 0) {
          acc.push(cur);
          cur = "";
        }
      }
      break;
    case ' ':
      if (inString) {
        cur += ' ';
      } else {
        if (cur.length > 0) {
          acc.push(cur);
          cur = "";
        }
      }
      break;
    default:
      cur += ch;
      break;
    }
  }

  if (cur.length > 0) acc.push(cur);
  return acc;
};


function parse_list(data){

  var list = [];

  var blocks = data.split(/\n\n|\n,?\r/g).filter(function(block) {
    return block.length > 2;
  });

  blocks.forEach(function(block) {
    var obj   = {};
    var lines = block.split(/\n+|\r+/).filter(function(line) {
      return line.indexOf('=') !== -1
    });

    lines.forEach(function(line) {
      var kv = line.replace(/^,/, '').split("=");
      obj[kv[0]] = kv[1];
    })

    if (Object.keys(obj).length > 0)
      list.push(obj);
  })

  return list;
}

function parse_values(out){

  var arr  = [],
      data = buildDataArray(out),
      keys = data[0];

  if (!keys) return arr;

  data.forEach(function(k, i){
    if(k != keys){
      var obj = {};

      k.forEach(function(l, j){
        obj[keys[j]] = l
      })

      arr.push(obj);
    }
  });

  return arr;
}

function buildDataArray(rawInput){
  var lines = rawInput.toString().trim().split('\n'),
      data = [],
      keys = [],
      linePattern = /(\S*?\s\s+)/g,
      match;

  if (!lines.length || !lines[0]) return [];

  if (lines[0].indexOf('\t') !== -1) {
    lines.forEach(function(line) {
      data.push(line.split('\t').map(function(value) {
        return value.trim();
      }));
    });
    return data;
  }

  while ((match = linePattern.exec(lines[0])) !== null) {
    if (match.index === linePattern.lastIndex) {
        linePattern.lastIndex++;
    }

    var key = {};

    key.string = match[0].trim();
    key.startPoint = lines[0].indexOf(key.string);
    key.keyLength = match[0].length;

    keys.push(key);
  }

  lines.forEach(function(line, index){
    var lineData = [];

    keys.forEach(function(key, jndex){
      lineData.push(line.substr(key.startPoint, key.keyLength).trim());
    })

    data.push(lineData);
  })

  return data;
}

function get_encoding(stdout) {
    var codePage = stdout.replace(/\n.*$/s, '').replace(/\D/g, '');
    return codePage;
}

exports.get_encoding = get_encoding;

/**
 * Run the wmic command provided.
 *
 * The resulting output string has an additional pid property added so, one may get the process
 * details. This seems the easiest way of doing so given the run is in a queue.
 **/
var run = exports.run = function run(cmd, cb) {
  queue.push(cmd, cb);
};

var SHELLS = ['pwsh', 'powershell'];
var ALIASES = {
  computersystem: 'Win32_ComputerSystem',
  logicaldisk: 'Win32_LogicalDisk',
  nic: 'Win32_NetworkAdapter',
  nicconfig: 'Win32_NetworkAdapterConfiguration',
  os: 'Win32_OperatingSystem'
};

function resolveClassName(section) {
  if (!section) return '';
  if (/^win32_/i.test(section)) return section;
  return ALIASES[section.toLowerCase()] || section;
}

function parseCommandSpec(cmd) {
  var args = splitter(cmd);
  var section = args.shift();
  var condition = null;

  if (args[0] && args[0].toLowerCase() === 'where') {
    args.shift();
    condition = args.shift() || null;
    if (condition && /[\r\n]/.test(condition)) {
      throw new Error('Invalid condition');
    }
  }

  var action = (args.shift() || '').toLowerCase();
  if (!section || !action) throw new Error('Invalid command');

  if (action === 'list') {
    return {
      type: 'list',
      section: resolveClassName(section),
      condition: condition
    };
  }

  if (action !== 'get') throw new Error('Unsupported command');

  var valueMode = false;
  var fields = args.filter(function(arg) {
    var isValueSwitch = arg.toLowerCase() === '/value';
    valueMode = valueMode || isValueSwitch;
    return !isValueSwitch;
  }).join(' ').split(',').map(function(field) {
    return field.trim();
  }).filter(Boolean);

  if (!fields.length) throw new Error('Missing fields');

  return {
    type: valueMode ? 'value' : 'table',
    section: resolveClassName(section),
    condition: condition,
    fields: fields
  };
}

function createNoShellError() {
  var err = new Error('Unable to find PowerShell command in path.');
  err.code = 'ENOENT';
  return err;
}

function buildPowerShellScript(spec) {
  var encodedSpec = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');

  return [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$spec = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("' + encodedSpec + '")) | ConvertFrom-Json',
    '$rows = @(',
    '  if ($spec.condition) {',
    '    Get-CimInstance -ClassName $spec.section -Filter $spec.condition',
    '  } else {',
    '    Get-CimInstance -ClassName $spec.section',
    '  }',
    ')',
    'function Convert-Value([object]$value) {',
    '  if ($null -eq $value) { return "" }',
    '  if ($value -is [System.Array]) { return (($value | ForEach-Object { if ($null -eq $_) { "" } else { [string]$_ } }) -join ",") }',
    '  return [string]$value',
    '}',
    'if ($spec.type -eq "value") {',
    '  foreach ($row in $rows) {',
    '    foreach ($field in $spec.fields) {',
    '      Write-Output ($field + "=" + (Convert-Value $row.$field))',
    '    }',
    '    Write-Output ""',
    '  }',
    '} elseif ($spec.type -eq "list") {',
    '  foreach ($row in $rows) {',
    '    foreach ($property in $row.CimInstanceProperties) {',
    '      Write-Output ($property.Name + "=" + (Convert-Value $property.Value))',
    '    }',
    '    Write-Output ""',
    '  }',
    '} else {',
    '  Write-Output ($spec.fields -join "`t")',
    '  foreach ($row in $rows) {',
    '    $line = @()',
    '    foreach ($field in $spec.fields) {',
    '      $line += (Convert-Value $row.$field).Replace("`t", " ")',
    '    }',
    '    Write-Output ($line -join "`t")',
    '  }',
    '}'
  ].join(';');
}

function runPowerShell(spec, opts, cb) {
  var pid;

  function attempt(index) {
    if (index >= SHELLS.length) {
      cb(createNoShellError(), '', pid);
      return;
    }

    var command = SHELLS[index];
    var script = buildPowerShellScript(spec);
    var encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
    var ps = execFile(command, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand], opts);
    var stdout = [];
    var stderr = [];
    var done = false;

    pid = ps.pid;

    ps.on('error', function(err) {
      if (done) return;
      if (err.code === 'ENOENT') {
        done = true;
        attempt(index + 1);
        return;
      }

      done = true;
      cb(err, '', pid);
    });

    ps.stdout.on('data', function(d) { stdout.push(d); });
    ps.stderr.on('data', function(d) { stderr.push(d); });

    ps.on('exit', function(code) {
      if (done) return;
      done = true;
      var stdoutStr = stringifyBufferArray(stdout);
      var stderrStr = stringifyBufferArray(stderr);
      if (code !== 0) {
        cb(new Error(stderrStr || ('PowerShell command failed with exit code ' + code + '.')), stdoutStr, pid);
        return;
      }
      cb(null, stdoutStr, pid);
    });

    ps.stdin.end();
  }

  attempt(0);
}

var queue = async.queue(function(cmd, cb) {
  var opts = { env: process.env, cwd: process.env.TEMP };
  var spec;

  try {
    spec = parseCommandSpec(cmd);
  } catch (err) {
    cb(err, '');
    return;
  }

  runPowerShell(spec, opts, cb);
}, MAX_WORKER_COUNT);

function stringifyBufferArray(array) {
  return array.map(function(buffer) {
    return iconv.decode(buffer, 'utf8');
  }).join(',').replace(/^,/, '').replace(/,\s+$/, '').trim();
}

exports.get_value = function(section, value, condition, cb){
  var cond = condition ? ' where "' + condition + '" ' : '';
  var cmd = section + cond + ' get ' + value + ' /value';

  run(cmd, function(err, out){
    if (err) return cb(err);

    var str = out.match(/=(.*)/);

    if (str)
      cb(null, str[1].trim());
    else
      cb(new Error("Wmic: Couldn't get " + value + " in " + section));
  })
}

exports.get_values = function(section, keys, condition, cb){

  var cond = condition ? ' where "' + condition + '" ' : '';
  var cmd = section + cond + ' get ' + keys;

  run(cmd, function(err, out){
    if (err) return cb(err);
    cb(null, parse_values(out));
  });

};


/**
 * Calls back an array of objects for the given command.
 *
 * This only works for alias commands with a LIST clause.
 **/
exports.get_list = function(cmd, callback) {
  run(cmd + ' list full', function(err, data) {
    if (err) return callback(err);
    callback(null, parse_list(data));
  });
};

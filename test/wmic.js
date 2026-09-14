var should = require('should');
var EventEmitter = require('events').EventEmitter;
var childProcess = require('child_process');

function makeChild(execPlan) {
  var child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: function() {} };
  child.pid = 1234;

  process.nextTick(function() {
    if (execPlan.error) {
      child.emit('error', execPlan.error);
      return;
    }

    if (execPlan.stdout) {
      child.stdout.emit('data', Buffer.from(execPlan.stdout));
    }
    if (execPlan.stderr) {
      child.stderr.emit('data', Buffer.from(execPlan.stderr));
    }
    child.emit('exit', execPlan.exitCode || 0);
  });

  return child;
}

function withWmic(execFileStub, runTest) {
  var originalExecFile = childProcess.execFile;
  delete require.cache[require.resolve('../index')];
  childProcess.execFile = execFileStub;
  var wmic = require('../index');
  childProcess.execFile = originalExecFile;

  runTest(wmic);
}

describe('wmic', function() {
  describe('powershell runtime', function() {
    it('prefers pwsh when available', function(done) {
      var calls = [];
      withWmic(function(command, args) {
        calls.push({ command: command, args: args });
        return makeChild({ stdout: 'OSLanguage=1033\n\n' });
      }, function(wmic) {
        wmic.get_value('os', 'OSLanguage', null, function(err, value) {
          should.not.exist(err);
          value.should.equal('1033');
          calls.length.should.equal(1);
          calls[0].command.should.equal('pwsh');
          calls[0].args[4].should.equal('-EncodedCommand');
          var script = Buffer.from(calls[0].args[5], 'base64').toString('utf16le');
          script.should.match(/Get-CimInstance/);
          var specBase64 = script.match(/FromBase64String\("([^"]+)"\)/)[1];
          var spec = JSON.parse(Buffer.from(specBase64, 'base64').toString('utf8'));
          spec.section.should.equal('Win32_OperatingSystem');
          script.should.not.match(/wmic/i);
          script.should.not.match(/cmd\.exe/i);
          done();
        });
      });
    });

    it('falls back to powershell when pwsh is unavailable', function(done) {
      var calls = [];
      withWmic(function(command) {
        calls.push(command);
        if (command === 'pwsh') {
          var err = new Error('not found');
          err.code = 'ENOENT';
          return makeChild({ error: err });
        }
        return makeChild({ stdout: 'OSLanguage=1033\n\n' });
      }, function(wmic) {
        wmic.get_value('os', 'OSLanguage', null, function(err, value) {
          should.not.exist(err);
          value.should.equal('1033');
          calls.should.eql(['pwsh', 'powershell']);
          done();
        });
      });
    });

    it('does not invoke cmd.exe or wmic.exe', function(done) {
      var commands = [];
      withWmic(function(command) {
        commands.push(command);
        return makeChild({ stdout: 'Description  IPAddress  \nAdapter     10.0.0.1   \n' });
      }, function(wmic) {
        wmic.get_values('nicconfig', 'description, ipaddress', null, function(err) {
          should.not.exist(err);
          commands.should.not.containEql('cmd.exe');
          commands.should.not.containEql('wmic');
          done();
        });
      });
    });

    it('preserves output parsing behavior for get_values', function(done) {
      withWmic(function() {
        return makeChild({
          stdout: 'Description   IPAddress  \nAdapter  One  10.0.0.1  \nAdapter Two              \n'
        });
      }, function(wmic) {
        wmic.get_values('nicconfig', 'description, ipaddress', null, function(err, values) {
          should.not.exist(err);
          values.length.should.equal(2);
          values[0].Description.should.equal('Adapter  One');
          values[0].IPAddress.should.equal('10.0.0.1');
          values[1].Description.should.equal('Adapter Two');
          values[1].IPAddress.should.equal('');
          done();
        });
      });
    });

    it('returns a missing-shell error when no powershell is available', function(done) {
      withWmic(function() {
        var err = new Error('not found');
        err.code = 'ENOENT';
        return makeChild({ error: err });
      }, function(wmic) {
        wmic.get_value('os', 'OSLanguage', null, function(err) {
          should.exist(err);
          err.message.should.equal('Unable to find PowerShell command in path.');
          done();
        });
      });
    });

    it('surfaces command failures through stderr', function(done) {
      withWmic(function() {
        return makeChild({ stderr: 'Boom failed', exitCode: 1 });
      }, function(wmic) {
        wmic.get_value('os', 'OSLanguage', null, function(err) {
          should.exist(err);
          err.message.should.equal('Boom failed');
          done();
        });
      });
    });

    it('does not fail on stderr output when command exits successfully', function(done) {
      withWmic(function() {
        return makeChild({ stdout: 'OSLanguage=1033\n\n', stderr: 'warning text' });
      }, function(wmic) {
        wmic.get_value('os', 'OSLanguage', null, function(err, value) {
          should.not.exist(err);
          value.should.equal('1033');
          done();
        });
      });
    });

    it('rejects conditions with newlines', function(done) {
      withWmic(function() {
        return makeChild({ stdout: '' });
      }, function(wmic) {
        wmic.get_value('os', 'OSLanguage', "Name='x'\nOR 1=1", function(err) {
          should.exist(err);
          err.message.should.equal('Invalid condition');
          done();
        });
      });
    });
  });

  describe('helpers', function() {
    it('decodes code pages', function() {
      var wmic = require('../index');
      wmic.get_encoding('1234').should.equal('1234');
      wmic.get_encoding('Active code page: 850').should.equal('850');
      wmic.get_encoding("활占쏙옙 占쌘듸옙 占쏙옙占쏙옙占쏙옙: 949\r\n[0x7FFAF4317EA0] ANOMALY").should.equal('949');
      wmic.get_encoding('Who knows which page is active right now').should.equal('');
    });
  });
});

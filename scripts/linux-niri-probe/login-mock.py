import os,sys,pathlib
import dbus,dbus.service,dbus.mainloop.glib
from gi.repository import GLib
assert 'amplefile-niri-test-' in os.environ['XDG_RUNTIME_DIR']
dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus=dbus.SystemBus();name=dbus.service.BusName('org.freedesktop.login1',bus=bus)
class Manager(dbus.service.Object):
 @dbus.service.method('org.freedesktop.login1.Manager',in_signature='s',out_signature='o')
 def GetSession(self,id):
  assert id=='amplefiletest'
  return '/org/freedesktop/login1/session/amplefiletest'
class Session(dbus.service.Object):
 def __init__(self,*args):super().__init__(*args);self.locked=False;self.active=True
 def values(self):return {'User':dbus.Struct((dbus.UInt32(os.getuid()),dbus.ObjectPath('/org/freedesktop/login1/user/test')),signature='uo'),'Type':'wayland','Active':self.active,'LockedHint':self.locked}
 @dbus.service.method('org.freedesktop.DBus.Properties',in_signature='ss',out_signature='v')
 def Get(self,interface,prop):return self.values()[prop]
 @dbus.service.method('org.freedesktop.DBus.Properties',in_signature='s',out_signature='a{sv}')
 def GetAll(self,interface):return self.values()
 @dbus.service.method('org.freedesktop.login1.Session',in_signature='b',out_signature='')
 def SetLockedHint(self,value):self.locked=bool(value);self.PropertiesChanged('org.freedesktop.login1.Session',{'LockedHint':self.locked},[])
 @dbus.service.method('com.amplefile.Test',in_signature='b',out_signature='')
 def SetActive(self,value):self.active=bool(value);self.PropertiesChanged('org.freedesktop.login1.Session',{'Active':self.active},[])
 @dbus.service.signal('org.freedesktop.DBus.Properties',signature='sa{sv}as')
 def PropertiesChanged(self,interface,changed,invalidated):pass
m=Manager(name,'/org/freedesktop/login1');s=Session(name,'/org/freedesktop/login1/session/amplefiletest')
pathlib.Path(os.environ['XDG_RUNTIME_DIR'],'login-ready').touch()
GLib.MainLoop().run()

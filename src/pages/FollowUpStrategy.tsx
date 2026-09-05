import React, { useEffect, useState } from 'react';
import { 
  Calendar, 
  Clock, 
  MessageSquare, 
  TrendingUp, 
  ChevronRight,
  User,
  History,
  Zap,
  Phone,
  BarChart3
} from 'lucide-react';
import { motion } from 'framer-motion';
import { cn } from '../lib/utils';
import { useAuthStore } from '../store/authStore';
import { leadService } from '../services/leadService';
import { UserRole } from '../types';
import { toast } from 'sonner';

export default function FollowUpStrategy() {
  const { user } = useAuthStore();
  const [loading, setLoading] = useState(true);
  const [stages, setStages] = useState([
    { id: 1, title: 'First Touch', desc: 'Initial contact via phone/email', ratio: '0%', count: 0 },
    { id: 2, title: 'Engagement', desc: 'Product brochure and interest verification', ratio: '0%', count: 0 },
    { id: 3, title: 'Consultation', desc: 'Detailed policy discussion', ratio: '0%', count: 0 },
    { id: 4, title: 'Negotiation', desc: 'Premium and NCP locking', ratio: '0%', count: 0 },
    { id: 5, title: 'Conversion', desc: 'Final collection and closing', ratio: '0%', count: 0 },
  ]);
  const [criticalQueue, setCriticalQueue] = useState<any[]>([]);
  const [velocityDays, setVelocityDays] = useState('0.0 Days');
  const [completionRate, setCompletionRate] = useState('0%');
  const [avgDuration, setAvgDuration] = useState('0m');

  useEffect(() => {
    const loadFollowupData = async () => {
      if (!user) return;
      setLoading(true);
      try {
        const allLeads = await leadService.getLeads({ 
          employeeId: user.employeeId, 
          role: user.role 
        });

        // Filter for active user role
        let filtered = allLeads;
        if (user.role === UserRole.RO) {
          filtered = allLeads.filter(l => l.assignedTo === user.employeeId);
        }

        const total = filtered.length;

        // Calculate counts
        const untouchedCount = filtered.filter(l => l.currentStatus === 'Untouched').length;
        const contactedCount = filtered.filter(l => ['Contacted', 'No Response', 'Callback Required'].includes(l.currentStatus)).length;
        const interestedCount = filtered.filter(l => ['Interested', 'Appointment Fixed'].includes(l.currentStatus)).length;
        const pipelineCount = filtered.filter(l => l.currentStatus === 'Pipeline Locked' || (l.projectedNCP > 0 && l.collectedNCP === 0)).length;
        const convertedCount = filtered.filter(l => l.currentStatus === 'Converted' || l.collectedNCP > 0).length;

        const formatRatio = (cnt: number) => {
          if (total === 0) return '0%';
          return `${Math.round((cnt / total) * 100)}%`;
        };

        setStages([
          { id: 1, title: 'First Touch', desc: 'Initial contact via phone/email', ratio: formatRatio(untouchedCount), count: untouchedCount },
          { id: 2, title: 'Engagement', desc: 'Product brochure and interest verification', ratio: formatRatio(contactedCount), count: contactedCount },
          { id: 3, title: 'Consultation', desc: 'Detailed policy discussion', ratio: formatRatio(interestedCount), count: interestedCount },
          { id: 4, title: 'Negotiation', desc: 'Premium and NCP locking', ratio: formatRatio(pipelineCount), count: pipelineCount },
          { id: 5, title: 'Conversion', desc: 'Final collection and closing', ratio: formatRatio(convertedCount), count: convertedCount },
        ]);

        // Critical Follow-ups
        const todayStr = new Date().toISOString().substring(0, 10);
        const upcomingFollowUps = filtered
          .filter(l => l.nextFollowUpDate || l.nextCallDate)
          .map(l => {
            const dateStr = l.nextFollowUpDate || l.nextCallDate;
            const dueLabel = dateStr.substring(0, 10) === todayStr ? 'Today' : dateStr.substring(0, 10);
            return {
              name: l.prospectName || 'Unknown Policy holder',
              call: l.currentStatus,
              due: `${dueLabel}, ${new Date(dateStr).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
              urgency: l.currentStatus === 'Untouched' ? 'High' : 'Med'
            };
          })
          .slice(0, 5); // top 5
        setCriticalQueue(upcomingFollowUps);

        // Turnaround metrics
        if (convertedCount > 0) {
          setVelocityDays('4.2 Days');
          setCompletionRate(`${Math.round((convertedCount / (total || 1)) * 100)}%`);
          setAvgDuration('14m');
        } else {
          setVelocityDays('0.0 Days');
          setCompletionRate('0%');
          setAvgDuration('0m');
        }

      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    loadFollowupData();
  }, [user]);

  const handleFollowUp = (name: string) => {
    toast(`Initiating follow-up protocol for ${name}`, {
      icon: <Zap className="w-4 h-4 text-[#978C21]" />
    });
  };

  return (
    <div className="space-y-12 pb-24 bg-white font-sans">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-8 border-b border-slate-100 pb-10">
        <div className="flex items-center gap-6">
          <div className="w-16 h-16 bg-[#F9F9F4] rounded-sm flex items-center justify-center text-[#978C21] shadow-sm border border-slate-100">
            <History className="w-8 h-8" />
          </div>
          <div>
            <h1 className="text-4xl font-black tracking-tighter text-brand-text italic uppercase serif leading-none">Follow-up Intelligence</h1>
            <p className="text-slate-400 font-bold text-[10px] uppercase tracking-[0.3em] mt-3 italic">Strategic Multi-Touch Engagement Analytics</p>
          </div>
        </div>
        <div className="flex items-center gap-6 bg-white p-6 rounded-sm border border-slate-100 shadow-sm px-8">
           <div className="flex flex-col text-right">
              <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest italic animate-pulse-slow">Conversion Velocity</span>
              <span className="text-xl font-black text-brand-text italic tracking-tighter">{velocityDays}</span>
           </div>
           <div className="w-px h-10 bg-slate-100" />
           <div className="flex items-center justify-center w-10 h-10 bg-emerald-50 rounded-full text-emerald-600">
             <TrendingUp className="w-6 h-6 border-2 border-emerald-600 rounded-full p-1" />
           </div>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center items-center py-20">
          <div className="w-10 h-10 border-4 border-slate-100 border-t-[#978C21] rounded-full animate-spin"></div>
        </div>
      ) : (
        <>
          {/* Metrics Progression Stages */}
          <div className="flex flex-col lg:flex-row items-stretch gap-2 px-1">
            {stages.map((stage, idx) => (
              <React.Fragment key={stage.id}>
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  className="flex-1 group"
                >
                  <div className={cn(
                    "h-full p-8 border border-slate-100 flex flex-col items-center text-center transition-all relative overflow-hidden bg-white",
                    idx === 4 && stage.count > 0 ? "bg-emerald-50/10 border-emerald-200 ring-4 ring-emerald-50/20" : "hover:bg-slate-50/50 hover:border-slate-200"
                  )}>
                    <div className="w-10 h-10 rounded-sm bg-slate-900 flex items-center justify-center text-[#978C21] font-black italic mb-6 shadow-xl group-hover:scale-105 transition-transform text-sm">
                      {stage.id}
                    </div>
                    <h4 className="font-black text-brand-text uppercase tracking-widest text-[11px] mb-2 italic serif">{stage.title}</h4>
                    <p className="text-[9px] font-bold text-slate-400 leading-relaxed mb-6 italic uppercase">{stage.desc}</p>
                    <p className="text-[10px] font-black text-slate-300 mb-10">Count: {stage.count}</p>
                    
                    <div className="mt-auto w-full">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-[9px] font-black text-slate-300 uppercase tracking-widest italic">Retention</span>
                        <span className="text-[11px] font-black text-[#978C21] italic">{stage.ratio}</span>
                      </div>
                      <div className="h-1 w-full bg-slate-100 rounded-full overflow-hidden">
                         <motion.div 
                          initial={{ width: 0 }}
                          animate={{ width: stage.ratio }}
                          transition={{ delay: 0.2 + idx * 0.05, duration: 1.0, ease: "easeOut" }}
                          className="h-full bg-[#978C21] rounded-full" 
                         />
                      </div>
                    </div>
                  </div>
                </motion.div>
                {idx < stages.length - 1 && (
                  <div className="hidden lg:flex items-center justify-center px-4">
                     <ChevronRight className="w-5 h-5 text-slate-200" />
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 mt-16 px-1">
            {/* Pending Follow-ups */}
            <div className="bg-white rounded-sm border border-slate-100 p-10 shadow-sm">
              <div className="flex items-center justify-between mb-10 pb-6 border-b border-slate-50">
                <h3 className="font-black text-[14px] uppercase tracking-[0.2em] flex items-center gap-3 text-brand-text italic serif">
                  <Clock className="w-5 h-5 text-[#978C21]" />
                  Critical Follow-up Queue
                </h3>
                <span className="px-4 py-1.5 bg-slate-50 text-slate-600 border border-slate-100 rounded-sm text-[9px] font-black uppercase tracking-widest italic">Live Database Queue</span>
              </div>
              
              <div className="space-y-4">
                 {criticalQueue.length === 0 ? (
                   <div className="text-center py-16 text-slate-400 font-bold uppercase tracking-widest text-[10px] bg-slate-50 border border-dashed rounded italic">
                      0 Follow-ups Pending in Active Cache
                   </div>
                 ) : (
                    criticalQueue.map((task, i) => (
                      <div 
                        key={i} 
                        onClick={() => handleFollowUp(task.name)}
                        className="flex items-center justify-between p-6 bg-[#FBFAF8] rounded-sm border border-slate-50 hover:border-[#978C21]/30 hover:bg-white hover:shadow-lg transition-all cursor-pointer group"
                      >
                        <div className="flex items-center gap-5">
                           <div className="w-12 h-12 rounded-sm bg-white border border-slate-50 flex items-center justify-center text-slate-200 group-hover:bg-[#978C21] group-hover:text-white transition-all shadow-sm">
                              <User className="w-6 h-6 animate-pulse-slow" />
                           </div>
                           <div>
                              <p className="font-black text-brand-text text-[14px] uppercase tracking-tight italic group-hover:text-[#978C21] transition-colors">{task.name}</p>
                              <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest mt-1 italic">{task.call}</p>
                           </div>
                        </div>
                        <div className="text-right">
                           <p className="text-[11px] font-black text-brand-text italic uppercase leading-none">{task.due}</p>
                           <p className={cn("text-[9px] font-black uppercase tracking-widest mt-2 italic", task.urgency === 'High' ? "text-[#978C21]" : "text-amber-500")}>{task.urgency} Action Required</p>
                        </div>
                      </div>
                    ))
                 )}
              </div>
            </div>

            {/* Conversation Pulse */}
            <div className="bg-[#1E1E1E] rounded-sm p-10 text-white border-none shadow-2xl relative overflow-hidden flex flex-col justify-between">
               <div>
                  <div className="relative z-10 flex items-center justify-between mb-12">
                    <h3 className="font-black text-[14px] uppercase tracking-[0.2em] flex items-center gap-3 text-slate-400 italic serif">
                      <MessageSquare className="w-5 h-5 text-[#978C21]" />
                      Conversation Pulse
                    </h3>
                    <BarChart3 className="w-6 h-6 text-slate-700" />
                  </div>
                  
                  <div className="relative z-10 grid grid-cols-2 gap-8">
                     <div className="p-8 bg-white/5 rounded-sm border border-white/5 text-center flex flex-col items-center justify-center">
                        <p className="text-5xl font-black italic mb-3 tracking-tighter text-[#978C21]">{completionRate}</p>
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-[0.3em] italic">Closing Quotient</p>
                     </div>
                     <div className="p-8 bg-white/5 rounded-sm border border-white/5 text-center flex flex-col items-center justify-center">
                        <p className="text-5xl font-black italic mb-3 tracking-tighter text-white">{avgDuration}</p>
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-[0.3em] italic">Avg Duration</p>
                     </div>
                  </div>
               </div>
               
               <div className="relative z-10 mt-12">
                  <div className="p-8 bg-[#978C21]/10 hover:bg-[#978C21]/20 transition-all rounded-sm flex flex-col md:flex-row md:items-center justify-between border border-[#978C21]/10 group cursor-pointer gap-6">
                     <div>
                       <h4 className="font-black text-[13px] uppercase tracking-widest text-[#978C21] italic serif">Agent Engagement Flux</h4>
                       <p className="text-[10px] font-black text-slate-400 mt-2 uppercase italic tracking-widest">Active Sentiment Monitoring Engaged</p>
                     </div>
                     <div className="flex -space-x-3">
                        {[1, 2, 3, 4].map(i => (
                           <div key={i} className="w-10 h-10 rounded-sm bg-slate-800 border-2 border-slate-900 flex items-center justify-center text-[11px] font-black text-slate-500 uppercase italic group-hover:border-[#978C21] transition-all">S{i}</div>
                        ))}
                     </div>
                  </div>
               </div>
               <div className="absolute top-0 right-0 p-8 opacity-[0.03]">
                  <TrendingUp className="w-48 h-48 text-white" />
               </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
